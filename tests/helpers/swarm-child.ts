/**
 * Child-process driver for cross-process concurrency tests.
 * Usage: bun run tests/helpers/swarm-child.ts --root DIR --op claim|board-post --agent A [--task task-1] [--start EPOCH_MS] [--count N]
 */
import { openDatabase, swarmPaths } from "../../extension/db";
import { SwarmStore } from "../../extension/store";

function arg(name: string, fallback?: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (value === undefined) {
		if (fallback === undefined) throw new Error(`missing --${name}`);
		return fallback;
	}
	return value;
}

const root = arg("root");
const op = arg("op");
const agent = arg("agent");
const startAt = Number(arg("start", "0"));
const paths = swarmPaths(root);
const store = new SwarmStore(openDatabase(paths), paths);

const wait = startAt - Date.now();
if (wait > 0) await Bun.sleep(wait);

if (op === "claim") {
	const taskId = arg("task");
	const capabilities = arg("caps", "").split(",").filter(Boolean);
	const result = store.claim(taskId, agent, 300, capabilities);
	console.log(JSON.stringify({ op, agent, taskId, ok: result.ok, reason: result.reason }));
} else if (op === "board-post") {
	const count = Number(arg("count", "10"));
	for (let i = 0; i < count; i++) {
		store.postBoard({ type: "FACT", agentId: agent, content: `${agent} entry ${i}`, tags: ["race"] });
	}
	console.log(JSON.stringify({ op, agent, count }));
} else if (op === "complete") {
	const taskId = arg("task");
	const result = store.complete(taskId, agent, { summary: arg("summary", "done"), reviewRequired: arg("review", "false") === "true" });
	console.log(JSON.stringify({ op, agent, taskId, ok: result.ok, reason: result.reason }));
} else {
	throw new Error(`unknown op ${op}`);
}

store.close();
