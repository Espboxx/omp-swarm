/**
 * Live swarm run driven through the OMP SDK.
 *
 * This boots the same SwarmDriver the extension uses, but from a plain Bun
 * process, so the swarm can be verified headlessly (no TUI, no RPC plumbing).
 *
 * Usage: bun run tests/integration/sdk-run.ts [--root DIR] [--workers N] [--timeout SECONDS] [--worktrees] [--no-review]
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as host from "@oh-my-pi/pi-coding-agent";
import * as zod from "@oh-my-pi/omptype/zod";
import { SwarmDriver, type TimerApi } from "../../extension/driver";
import { loadSwarmConfig } from "../../extension/config";
import { openDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import { evaluate, pickCrashVictim, prepareProject, printResults, readEvents, seedTasks, unclaimableReadyWork, type LoggedEvent } from "./harness";

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	return value ?? fallback;
}

const has = (name: string) => process.argv.includes(`--${name}`);

const root = resolve(arg("root", join(import.meta.dir, "..", "..", "scratch", "sdkrun")));
const workers = Number(arg("workers", "4"));
const timeoutSeconds = Number(arg("timeout", "900"));
const worktrees = has("worktrees");
const review = !has("no-review");

/** Raw timers with contained throws (the extension path uses `ctx.setInterval`). */
const timers: TimerApi = {
	setInterval: (callback: (...args: unknown[]) => void, ms?: number) =>
		setInterval(() => {
			try {
				callback();
			} catch (error) {
				console.error(`[driver] timer callback threw: ${error instanceof Error ? error.message : String(error)}`);
			}
		}, ms),
	clearTimer: (timer: Timer) => clearInterval(timer),
};

async function exec(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

async function main(): Promise<void> {
	prepareProject({ root, workers, review, worktrees });
	const paths = swarmPaths(root);
	const store = new SwarmStore(openDatabase(paths), paths);
	const taskIds = seedTasks(store, review);
	console.log(`[bootstrap] seeded ${taskIds.join(", ")} in ${root}`);

	const driver = new SwarmDriver({
		sdk: host,
		store,
		config: loadSwarmConfig(paths.configFile),
		root,
		z: zod,
		timers,
		exec,
		notify: (text, level) => console.log(`[${level ?? "info"}] ${text}`),
		onPanel: () => {
			console.log(`[panel] ${driver.panelLines().join(" | ")}`);
		},
	});

	const planned = await driver.start(workers);
	console.log(`[bootstrap] planned workers: ${planned.join(", ")}`);
	const spawnDeadline = Date.now() + 180_000;
	while (driver.workers.length === 0 && Date.now() < spawnDeadline) await Bun.sleep(1000);
	console.log(`[bootstrap] live workers: ${driver.workers.map((w) => w.name).join(", ") || "(none)"}`);
	if (driver.workers.length === 0) {
		console.error("[bootstrap] no worker session came up; aborting");
		await driver.stop("no workers");
		process.exit(1);
	}

	const begin = Date.now();
	let crashInjected = false;
	let lastEventCount = 0;
	while (Date.now() - begin < timeoutSeconds * 1000) {
		const events: LoggedEvent[] = readEvents(root);
		const counts = store.counts();
		if (events.length !== lastEventCount) {
			lastEventCount = events.length;
			const latest = events.slice(-3).map((e) => `${e.type}${e.taskId ? `(${e.taskId})` : ""}${e.agentId ? ` ${e.agentId}` : ""}`);
			console.log(
				`[t+${Math.round((Date.now() - begin) / 1000)}s] ready=${counts.ready} claimed=${counts.claimed} review=${counts.review} done=${counts.done} failed=${counts.failed} | ${latest.join(" , ")}`,
			);
		}
		if (!crashInjected && counts.claimed > 0) {
			// Never kill the only live holder of a capability that unfinished work still needs: that
			// strands capability-gated work forever (the integration task here) and the run just burns
			// its timeout instead of exercising the review cycle.
			const holder = pickCrashVictim(store);
			if (holder) {
				const crashed = await driver.simulateCrash(holder.id);
				if (crashed) {
					crashInjected = true;
					console.log(
						`[crash-test] killed worker ${holder.id} (${holder.role} · ${holder.capabilities.join(",") || "no caps"}) while it held ${holder.currentTask}; its lease must expire before a peer can take it`,
					);
				}
			}
		}
		const tasks = taskIds.map((id) => store.getTask(id)).filter((t) => t !== undefined);
		if (tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "failed")) break;
		if (Date.now() - begin > 30_000 && counts.claimed === 0 && counts.review === 0) {
			const stranded = unclaimableReadyWork(store);
			if (stranded.tasks.length > 0) {
				console.log(
					`[stuck] ready work no live worker is capable of claiming: ${stranded.tasks.join(", ")} (${stranded.agents} live agent(s)); ending the run instead of waiting for the timeout`,
				);
				break;
			}
		}
		await Bun.sleep(2000);
	}

	const events = readEvents(root);
	const offline = store.listAgents().filter((a) => a.status === "offline").map((a) => a.id);
	if (offline.length > 0) console.log(`[crash-test] offline agents after recovery: ${offline.join(", ")}`);
	await driver.stop("integration run finished");
	const { results, report } = evaluate({
		root,
		workers,
		review,
		durationSeconds: Math.round((Date.now() - begin) / 1000),
		taskIds,
		events,
	});
	const out = join(import.meta.dir, "last-run.json");
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`\n[report] wrote ${out}`);
	const failed = printResults(results);
	store.close();
	process.exit(failed === 0 ? 0 : 1);
}

await main();
