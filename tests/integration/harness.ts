/**
 * Shared integration harness: scratch project, seeded tasks, and the assertions
 * every runner (RPC-driven and SDK-driven) evaluates against the shared database.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";
import type { SwarmAgent } from "../../extension/types";

export interface LoggedEvent {
	type: string;
	agentId?: string;
	taskId?: string;
	data?: Record<string, unknown>;
	createdAt: number;
}

export interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

export interface HarnessOptions {
	root: string;
	workers: number;
	review: boolean;
	worktrees: boolean;
}

export function prepareProject(options: HarnessOptions): void {
	rmSync(options.root, { recursive: true, force: true });
	mkdirSync(join(options.root, "src"), { recursive: true });
	mkdirSync(join(options.root, ".swarm"), { recursive: true });
	writeFileSync(
		join(options.root, "package.json"),
		`${JSON.stringify({ name: "swarm-itest", private: true, type: "module", scripts: { test: "bun test" } }, null, 2)}\n`,
	);
	writeFileSync(
		join(options.root, ".swarm", "config.json"),
		`${JSON.stringify(
			{
				workers: options.workers,
				leaseSeconds: 30,
				heartbeatSeconds: 5,
				offlineAfterSeconds: 20,
				idleTickSeconds: 10,
				review: options.review,
				worktrees: options.worktrees,
				tools: ["read", "grep", "glob", "edit", "write", "bash", "todo"],
				roles: [
					{ name: "general", count: Math.max(1, options.workers - 2), capabilities: ["general"] },
					{ name: "reviewer", count: 1, capabilities: ["general", "reviewer"] },
					{ name: "integrator", count: 1, capabilities: ["integrator", "reviewer"] },
				],
			},
			null,
			2,
		)}\n`,
	);
}

/** Bootstrap tasks: real code, a deliberate dead end, a social exchange, an integration gate. */
export function seedTasks(store: SwarmStore, review: boolean): string[] {
	const parser = store.createTask({
		title: "Implement src/parser.ts",
		priority: 10,
		createdBy: "bootstrap",
		files: ["src/parser.ts", "src/parser.test.ts"],
		description:
			"Create src/parser.ts exporting `parseKV(input: string): Record<string, string>` that parses lines of the form key=value, trims whitespace, ignores empty lines, and throws `new Error('malformed line')` for a line without '='. Add src/parser.test.ts using bun:test covering a normal case, an empty line, and the malformed line. Run `bun test` and include the output in your completion summary.",
	});
	const readme = store.createTask({
		title: "Write README.md",
		priority: 5,
		createdBy: "bootstrap",
		dependencies: [parser.id],
		files: ["README.md"],
		description:
			"Write README.md documenting the parseKV helper from src/parser.ts with a short usage example and one sentence about error behaviour. Read src/parser.ts first so the documented behaviour matches the code.",
	});
	const probe = store.createTask({
		title: "Audit the build setup and report dead ends",
		priority: 8,
		createdBy: "bootstrap",
		description:
			"Investigate how this project is built: read package.json and try to run the build. There is no build script. Post a FAIL board entry (board_post type=FAIL) containing the exact error text you observed, then complete this task with a summary of what you tried.",
	});
	const social = store.createTask({
		title: "Ask a peer for its status",
		priority: 3,
		createdBy: "bootstrap",
		description:
			"Call swarm_agents to list peers, then swarm_message one other agent asking what it is currently working on. Read its reply with swarm_inbox and record it with board_post type=OBSERVATION. Then complete this task.",
	});
	const integrate = store.createTask({
		title: "Integrate parser + docs",
		priority: 4,
		createdBy: "bootstrap",
		dependencies: [parser.id, readme.id],
		requiredCapabilities: ["integrator"],
		reviewRequired: review,
		description:
			"Verify the parser and its documentation agree: read src/parser.ts and README.md, run `bun test`, and post a DECISION board entry stating whether they are consistent. If they disagree, fix README.md and say so.",
	});
	return [parser.id, readme.id, probe.id, social.id, integrate.id];
}

export function readEvents(root: string): LoggedEvent[] {
	const file = join(root, ".swarm", "events.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as LoggedEvent);
}

/** Expire the lease of one claimed task to emulate a crashed worker. */
export function expireOneLease(root: string, store: SwarmStore): string | undefined {
	const victim = store.listTasks({ status: "claimed", limit: 1 })[0];
	if (!victim) return undefined;
	const raw = openDatabase(swarmPaths(root));
	raw.run("UPDATE tasks SET lease_until=? WHERE id=?", Date.now() - 5000, victim.id);
	raw.close();
	return victim.id;
}

/**
 * Choose a working agent to kill in the crash test: it must hold a task (so the reclaim is
 * observable on a real claim) and it must not be the only live holder of a capability that
 * unfinished work still requires. Killing the sole `integrator` strands the integration task as
 * permanently unclaimable, which is a harness artifact, not swarm behaviour.
 */
export function pickCrashVictim(store: SwarmStore): SwarmAgent | undefined {
	const live = store.listAgents().filter((agent) => agent.status !== "offline");
	const open = store.listTasks({ status: ["ready", "claimed", "review", "blocked"], limit: 100 });
	const required = new Set(open.flatMap((task) => task.requiredCapabilities));
	const irreplaceable = (agent: SwarmAgent) =>
		[...required].some((capability) => agent.capabilities.includes(capability) && !live.some((peer) => peer.id !== agent.id && peer.capabilities.includes(capability)));
	return live.find((agent) => agent.status === "working" && agent.currentTask !== undefined && !irreplaceable(agent));
}

/** Ready work no live agent is capable of claiming: the pool stalls there, so the run should end. */
export function unclaimableReadyWork(store: SwarmStore): { tasks: string[]; agents: number } {
	const agents = store.listAgents().filter((agent) => agent.status !== "offline");
	const stranded = store
		.listTasks({ status: "ready", limit: 100 })
		.filter((task) => task.requiredCapabilities.length > 0 && !agents.some((agent) => task.requiredCapabilities.some((capability) => agent.capabilities.includes(capability))));
	return { tasks: stranded.map((task) => `${task.id}:${task.requiredCapabilities.join("+")}`), agents: agents.length };
}

export interface EvaluateOptions {
	root: string;
	workers: number;
	review: boolean;
	durationSeconds: number;
	taskIds: string[];
	events: LoggedEvent[];
}

export function evaluate(options: EvaluateOptions): { results: CheckResult[]; report: Record<string, unknown> } {
	const paths = swarmPaths(options.root);
	const store = new SwarmStore(openDatabase(paths), paths);
	const results: CheckResult[] = [];
	const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });
	const events = options.events;

	const seenAgents = new Set(events.filter((e) => e.agentId).map((e) => e.agentId as string));
	const claimedAgents = new Set(events.filter((e) => e.type === "task.claim" && e.agentId).map((e) => e.agentId as string));
	check("workers registered and joined", seenAgents.size >= options.workers, `agents seen: ${[...seenAgents].join(", ")}`);
	check("at least two distinct agents claimed work", claimedAgents.size >= 2, `claiming agents: ${[...claimedAgents].join(", ")}`);

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
	check("no task was held by two agents at once", overlaps === 0, `${overlaps} overlapping claim window(s)`);

	check("src/parser.ts exists", existsSync(join(options.root, "src", "parser.ts")), "worker-created artifact");
	check("src/parser.test.ts exists", existsSync(join(options.root, "src", "parser.test.ts")), "worker-created test");
	check("README.md exists", existsSync(join(options.root, "README.md")), "worker-created documentation");
	if (existsSync(join(options.root, "src", "parser.ts"))) {
		const source = readFileSync(join(options.root, "src", "parser.ts"), "utf8");
		check("parser exports parseKV", source.includes("parseKV"), `${source.split("\n").length} lines written by a worker`);
	}
	if (existsSync(join(options.root, "src", "parser.test.ts"))) {
		const testRun = Bun.spawnSync(["bun", "test"], { cwd: options.root });
		const output = testRun.stdout.toString().trim().split("\n").filter((line) => line.trim() !== "");
		check("the swarm-written test suite passes", testRun.exitCode === 0, (output.at(-2) ?? output.at(-1) ?? "no output").slice(0, 140));
	}

	check("peer messaging was used", events.some((e) => e.type === "message.send"), `${events.filter((e) => e.type === "message.send").length} message(s)`);
	const board = store.searchBoard({ limit: 300 });
	const fails = board.filter((e) => e.type === "FAIL");
	check("a FAIL was published to the blackboard", fails.length > 0, fails[0]?.content.slice(0, 140) ?? "none");
	check("RESULT entries recorded", board.some((e) => e.type === "RESULT"), `${board.filter((e) => e.type === "RESULT").length} result(s)`);
	check("integration produced a DECISION entry", board.some((e) => e.type === "DECISION"), board.find((e) => e.type === "DECISION")?.content.slice(0, 140) ?? "none");
	if (options.review) {
		const started = events.filter((e) => e.type === "review.start").length;
		const approved = events.filter((e) => e.type === "review.approve").length;
		check("review cycle ran", started > 0 && approved > 0, `${started} started, ${approved} approved`);
	}
	const reclaims = events.filter((e) => e.type === "task.reclaim" && e.data?.reason === "lease-expired");
	const claimAfterReclaim = reclaims.length > 0 && events.some((e) => e.type === "task.claim" && e.createdAt > reclaims[0].createdAt);
	check(
		"expired lease was reclaimed and the task re-claimed by a peer",
		reclaims.length > 0 && claimAfterReclaim,
		`${reclaims.length} lease-expiry reclaim(s) of ${events.filter((e) => e.type === "task.reclaim").length} total`,
	);

	const tasks = options.taskIds.map((id) => store.getTask(id)).filter((t) => t !== undefined);
	check(
		"seeded tasks reached a terminal or review state",
		tasks.every((t) => t.status === "done" || t.status === "failed" || t.status === "review"),
		tasks.map((t) => `${t.id}:${t.status}`).join(", "),
	);
	const allTasks = store.listTasks({ limit: 100 });
	check(
		"no task was left claimed after shutdown",
		allTasks.every((t) => t.status !== "claimed"),
		allTasks.filter((t) => t.status === "claimed").map((t) => t.id).join(", ") || "none claimed",
	);

	const report = {
		root: options.root,
		workers: options.workers,
		durationSeconds: options.durationSeconds,
		agents: [...seenAgents],
		claimingAgents: [...claimedAgents],
		tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, attempts: t.attempts, result: t.result?.slice(0, 240) })),
		boardCounts: store.boardCounts(),
		eventCounts: events.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }), {}),
		results,
	};
	store.close();
	return { results, report };
}

export function printResults(results: CheckResult[]): number {
	for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`);
	const failed = results.filter((r) => !r.ok).length;
	console.log(`\n${results.length - failed}/${results.length} checks passed`);
	return failed;
}
