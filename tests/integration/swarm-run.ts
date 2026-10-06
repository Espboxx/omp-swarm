/**
 * Live swarm run inside a real OMP process, driven through RPC mode.
 *
 * Boots `omp --mode rpc --no-ui` with the extension loaded, dispatches
 * `/swarm start N` like a user would, and asserts on the shared database and
 * event log afterwards. Use `SWARM_TRACE=1` for a per-worker driver log.
 *
 * Usage: bun run tests/integration/swarm-run.ts [--root DIR] [--workers N] [--timeout SECONDS] [--worktrees] [--no-review]
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import { evaluate, expireOneLease, prepareProject, printResults, readEvents, seedTasks, type LoggedEvent } from "./harness";
import { RpcClient } from "./rpc-client";

const EXTENSION = resolve(import.meta.dir, "..", "..", "extension", "index.ts");

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	return value ?? fallback;
}

const has = (name: string) => process.argv.includes(`--${name}`);

const root = resolve(arg("root", join(import.meta.dir, "..", "..", "scratch", "itest")));
const workers = Number(arg("workers", "4"));
const timeoutSeconds = Number(arg("timeout", "900"));
const worktrees = has("worktrees");
const review = !has("no-review");

async function main(): Promise<void> {
	prepareProject({ root, workers, review, worktrees });
	const paths = swarmPaths(root);
	const store = new SwarmStore(openDatabase(paths), paths);
	const taskIds = seedTasks(store, review);
	console.log(`[bootstrap] seeded ${taskIds.join(", ")} in ${root}`);
	store.close();

	const client = new RpcClient(
		["omp", "--mode", "rpc", "--no-ui", "--no-session", ...(has("installed") ? [] : ["-e", EXTENSION]), "--no-title"],
		root,
	);
	const begin = Date.now();
	const probe = new SwarmStore(openDatabase(paths), paths);
	try {
		await client.waitForReady();
		console.log("[bootstrap] omp rpc session ready; dispatching /swarm start");
		await client.request({ type: "prompt", message: `/swarm start ${workers}` }, 600_000);
		const spawnDeadline = Date.now() + 240_000;
		while (probe.listAgents().filter((a) => a.id !== "main").length === 0 && Date.now() < spawnDeadline) await Bun.sleep(2000);
		const joined = probe.listAgents().filter((a) => a.id !== "main").map((a) => a.id);
		console.log(`[bootstrap] workers registered inside omp: ${joined.join(", ") || "(none)"}`);
		if (joined.length === 0) throw new Error("no worker session came up inside the omp process");
	} catch (error) {
		console.error(`[bootstrap] start failed: ${error instanceof Error ? error.message : String(error)}`);
		console.error(client.stderr.slice(-4000));
		await client.close();
		process.exit(1);
	} finally {
		probe.close();
	}

	const observer = new SwarmStore(openDatabase(paths), paths);
	let crashInjected = false;
	let lastEventCount = 0;
	while (Date.now() - begin < timeoutSeconds * 1000) {
		const events: LoggedEvent[] = readEvents(root);
		const counts = observer.counts();
		if (events.length !== lastEventCount) {
			lastEventCount = events.length;
			const latest = events.slice(-3).map((e) => `${e.type}${e.taskId ? `(${e.taskId})` : ""}${e.agentId ? ` ${e.agentId}` : ""}`);
			console.log(
				`[t+${Math.round((Date.now() - begin) / 1000)}s] ready=${counts.ready} claimed=${counts.claimed} review=${counts.review} done=${counts.done} failed=${counts.failed} | ${latest.join(" , ")}`,
			);
		}
		if (!crashInjected && counts.claimed > 0) {
			const victim = expireOneLease(root, observer);
			if (victim) {
				crashInjected = true;
				console.log(`[crash-test] expired the lease of ${victim}; expecting a reclaim`);
			}
		} else if (crashInjected && !events.some((e) => e.type === "task.reclaim" && e.data?.reason === "lease-expired") && Date.now() - begin < 200_000) {
			// Workers renew their leases on every tool call, so a single expiry is not
			// enough to emulate a stalled worker: keep the clock ahead until the sweeper wins.
			const victim = observer.listTasks({ status: "claimed", limit: 1 })[0];
			if (victim) {
				const raw = openDatabase(paths);
				raw.run("UPDATE tasks SET lease_until=? WHERE id=?", Date.now() - 5000, victim.id);
				raw.close();
			}
		}
		const tasks = taskIds.map((id) => observer.getTask(id)).filter((t) => t !== undefined);
		if (tasks.length > 0 && tasks.every((t) => t.status === "done" || t.status === "failed")) break;
		await Bun.sleep(2000);
	}

	const events = readEvents(root);
	observer.close();
	await client.request({ type: "prompt", message: "/swarm stop" }, 120_000).catch(() => undefined);
	await client.close();

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
	process.exit(printResults(results) === 0 ? 0 : 1);
}

await main();
